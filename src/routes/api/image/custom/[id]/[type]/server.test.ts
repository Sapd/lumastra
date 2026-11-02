// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/image/custom/[id]/[type].
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files (even though svelte-check/eslint/vitest pass).
 *
 * Fix round 2 (2026-09-25 image-footprint audit): this route has its OWN
 * `EXT_TO_CONTENT_TYPE` map, separate from image-proxy/service.ts's copy
 * (fixed in round 1). At `size=full` (the default via `parseImageSize`),
 * `resizeForPreset` returns the on-disk buffer UNCHANGED and the route
 * forwards `EXT_TO_CONTENT_TYPE[ext] ?? 'application/octet-stream'` straight
 * into `imageResponse()` as the Content-Type. Round 1 made `storeMediaImage`
 * write custom/provider artwork as `.avif`; without this route's own map
 * knowing `.avif`, every such file would be served as
 * `application/octet-stream` instead of `image/avif`.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from './$types.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

const mockGetDb = vi.fn();
const mockGetLocalArtwork = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockReadFile = vi.fn();

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: mockGetDb,
}));

vi.mock('$lib/server/database/queries/media-artwork.queries.js', () => ({
    getLocalArtwork: mockGetLocalArtwork,
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));

// Real path-containment logic isn't under test here — the fixture's
// file_path is asserted servable so the route reaches the content-type
// mapping this test is actually about.
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    isPathWithin: vi.fn().mockReturnValue(true),
    isPathWithinLibraryRoots: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        BASE_PATH: '/data',
        IMAGE_AVIF_ENABLED: true,
        IMAGE_WEBP_ENABLED: true,
    },
}));

// The containment itself is tested on a real filesystem in contained-fs.test.ts.
vi.mock('$lib/server/utils/contained-fs.js', () => ({
    readContainedFile: mockReadFile,
}));

// imageResponse itself is real (pure header-building logic) — only its own
// dependency (bandwidth tracking) needs stubbing. Pulling it in via the
// package's response.js directly avoids the heavy service.ts import chain
// (tmdb/jellyfin providers, task registry) that the index barrel carries.
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackImage: vi.fn() },
}));
vi.mock('$lib/server/services/image-proxy', async () => {
    const actual = await import('$lib/server/services/image-proxy/response.js');
    return { imageResponse: actual.imageResponse };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEDIA_ITEM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const fakeSql = vi.fn();

function makeEvent(
    id: string,
    type: string,
    searchParams: Record<string, string> = {},
): RequestEvent {
    const base = `http://localhost/api/image/custom/${id}/${type}`;
    const url = new URL(base);
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return {
        params: { id, type },
        url,
        request: new Request(url.toString()),
        locals: { user: null },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(fakeSql);
});

describe('GET /api/image/custom/[id]/[type]', () => {
    test('serves a stored .avif file as image/avif, not application/octet-stream', async () => {
        mockGetLocalArtwork.mockResolvedValue({
            file_path: `/data/.metadata/${MEDIA_ITEM_ID}/backdrop.avif`,
        });
        const avifBytes = Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]);
        mockReadFile.mockResolvedValue(avifBytes);

        const { GET } = await import('./+server.js');
        const event = makeEvent(MEDIA_ITEM_ID, 'backdrop');
        const response = await GET!(event);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/avif');
    });

    test('still serves a stored .jpg file as image/jpeg (no regression)', async () => {
        mockGetLocalArtwork.mockResolvedValue({
            file_path: `/data/.metadata/${MEDIA_ITEM_ID}/poster.jpg`,
        });
        mockReadFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));

        const { GET } = await import('./+server.js');
        const event = makeEvent(MEDIA_ITEM_ID, 'poster');
        const response = await GET!(event);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/jpeg');
    });

    test('re-contains the stored path when serving it (a link swapped in since is refused)', async () => {
        const filePath = `/data/.metadata/${MEDIA_ITEM_ID}/poster.jpg`;
        mockGetLocalArtwork.mockResolvedValue({ file_path: filePath });
        mockReadFile.mockRejectedValue(
            Object.assign(new Error('refusing'), { code: 'ECONTAINMENT' }),
        );

        const { GET } = await import('./+server.js');
        const response = await GET!(makeEvent(MEDIA_ITEM_ID, 'poster'));

        expect(response.status).toBe(404);
        expect(mockReadFile).toHaveBeenCalledWith(
            filePath,
            expect.objectContaining({
                parents: true,
                extraRoots: expect.arrayContaining(['/data/.metadata']),
            }),
        );
    });
});
