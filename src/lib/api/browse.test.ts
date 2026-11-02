// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the browse API domain module — genre/tag wiring on getAzBrowse().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({
    browser: false,
    dev: false,
}));

const mockMonitoredFetch = vi.fn();
const mockHandleAuthExpiration = vi.fn();

vi.mock('$lib/auth-monitor.js', () => ({
    monitoredFetch: (...args: unknown[]) => mockMonitoredFetch(...args),
    handleAuthExpiration: (...args: unknown[]) => mockHandleAuthExpiration(...args),
}));

const { getAzBrowse, getBrowseKeywords } = await import('./browse.js');

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function requestedUrl(callIndex = 0): string {
    const call = mockMonitoredFetch.mock.calls[callIndex] as [string, RequestInit] | undefined;
    if (!call) throw new Error(`monitoredFetch was not called (index ${callIndex})`);
    return call[0];
}

describe('getAzBrowse', () => {
    it('combines trimmed title search with library and playback filters', async () => {
        await getAzBrowse({ q: '  Quiet  ', libraryGroupId: 'kids', res: ['4K'] });
        const url = new URL(requestedUrl(), 'https://example.test');
        expect(url.searchParams.get('q')).toBe('Quiet');
        expect(url.searchParams.get('libraryGroupId')).toBe('kids');
        expect(url.searchParams.get('res')).toBe('4K');
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mockMonitoredFetch.mockResolvedValue(
            jsonResponse({ items: [], page: { limit: 50, offset: 0, hasMore: false, total: 0 } }),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('puts genre=Action in the request URL when genre is provided', async () => {
        await getAzBrowse({ genre: 'Action' });

        expect(mockMonitoredFetch).toHaveBeenCalledTimes(1);
        expect(requestedUrl()).toContain('genre=Action');
    });

    it('puts tag=whodunit in the request URL when tag is provided', async () => {
        await getAzBrowse({ tag: 'whodunit' });

        expect(mockMonitoredFetch).toHaveBeenCalledTimes(1);
        expect(requestedUrl()).toContain('tag=whodunit');
    });

    it('omits genre and tag entirely when not provided', async () => {
        await getAzBrowse({ type: 'movie' });

        const url = requestedUrl();
        expect(url).not.toContain('genre=');
        expect(url).not.toContain('tag=');
    });

    it('omits genre and tag entirely when passed as empty strings', async () => {
        await getAzBrowse({ genre: '', tag: '' });

        const url = requestedUrl();
        expect(url).not.toContain('genre=');
        expect(url).not.toContain('tag=');
    });

    it('passes genre and tag through verbatim, without lowercasing or trimming', async () => {
        await getAzBrowse({ genre: 'Sci-Fi', tag: 'Time Travel' });

        const url = requestedUrl();
        // URLSearchParams.toString() encodes spaces as '+', not '%20'.
        expect(url).toContain('genre=Sci-Fi');
        expect(url).toContain('tag=Time+Travel');
    });

    it('exposes non-empty genreCounts and keywordCounts on the parsed result', async () => {
        mockMonitoredFetch.mockResolvedValue(
            jsonResponse({
                items: [],
                page: { limit: 50, offset: 0, hasMore: false, total: 0 },
                genreCounts: [{ name: 'Action', count: 12 }],
                keywordCounts: [{ keyword: 'whodunit', count: 3 }],
            }),
        );

        const result = await getAzBrowse({ genre: 'Action' });

        expect(result.error).toBeNull();
        expect(result.data?.genreCounts?.length).toBeGreaterThan(0);
        expect(result.data?.genreCounts?.[0]).toEqual({ name: 'Action', count: 12 });
        expect(result.data?.keywordCounts?.length).toBeGreaterThan(0);
        expect(result.data?.keywordCounts?.[0]).toEqual({ keyword: 'whodunit', count: 3 });
    });
});

describe('keyword collection decoding', () => {
    it('decodes MediaPreview section items and canonical page metadata', async () => {
        mockMonitoredFetch.mockResolvedValue(
            jsonResponse({
                items: [
                    {
                        keyword: 'Space',
                        keywordId: 1,
                        items: [
                            {
                                id: 'film',
                                catalogId: '11111111-1111-4111-8111-111111111111',
                                ids: {},
                                type: 'movie',
                                title: 'Quiet Orbit',
                                images: {},
                            },
                        ],
                    },
                ],
                availableKeywords: [{ id: 1, name: 'Space' }],
                page: { limit: 1, offset: 0, hasMore: true, total: 2 },
            }),
        );
        const result = await getBrowseKeywords({ limit: 1 });
        expect(result.error).toBeNull();
        expect(result.data?.items[0].items[0].title).toBe('Quiet Orbit');
        expect(result.data?.page).toEqual({ limit: 1, offset: 0, hasMore: true, total: 2 });
    });
});
