// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

const mockConfig = vi.hoisted(() => ({
    TMDB_API_KEY: '0123456789abcdef0123456789abcdef',
}));

vi.mock('$lib/server/config', () => ({
    config: {
        get TMDB_API_KEY() {
            return mockConfig.TMDB_API_KEY;
        },
        TMDB_METADATA_CACHE_TTL_DAYS: 180,
        IMAGE_THUMB_QUALITY: 75,
        IMAGE_FULL_QUALITY: 85,
        IMAGE_WEBP_ENABLED: false,
    },
}));

vi.mock('$lib/server/utils/fetch-utils', () => ({
    TIMEOUTS: { MEDIUM: 1000 },
    fetchWithTimeout: vi.fn(async () => ({
        ok: true,
        json: async () => ({ still_path: '/episode-still.jpg' }),
    })),
}));

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils';
import { TmdbImageProvider } from './tmdb.provider';
import sharp from 'sharp';

type GetImagePath = (
    tmdbId: string,
    mediaType: 'movie' | 'tv' | 'episode' | 'season',
    type: 'poster' | 'backdrop' | 'logo' | 'still' | 'primary' | 'banner' | 'thumb',
    options: { catalogId?: string; path?: string },
) => Promise<string | null>;

function makeProvider() {
    const sql = vi.fn(async () => [
        {
            series_tmdb_id: '314',
            season_number: 1,
            episode_number: 1,
            title: 'Broken Bow',
        },
    ]);
    const provider = new TmdbImageProvider(sql as never);
    const getImagePath = (provider as unknown as { getImagePath: GetImagePath }).getImagePath.bind(
        provider,
    );

    return { provider, getImagePath };
}

describe('TmdbImageProvider episode image lookup', () => {
    beforeEach(() => {
        vi.mocked(fetchWithTimeout).mockClear();
        mockConfig.TMDB_API_KEY = V3_KEY;
    });

    it('sends a v3 API key as ?api_key= without a Bearer header', async () => {
        const { getImagePath } = makeProvider();

        const path = await getImagePath('314', 'episode', 'thumb', {
            catalogId: '2a49f020-65f2-4abc-92a4-b5b68d15934a',
        });

        expect(path).toBe('/episode-still.jpg');
        expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
        const [url, init, timeout] = vi.mocked(fetchWithTimeout).mock.calls[0];
        const parsed = new URL(String(url));
        expect(parsed.origin + parsed.pathname).toBe(
            'https://api.themoviedb.org/3/tv/314/season/1/episode/1',
        );
        expect(parsed.searchParams.get('api_key')).toBe(V3_KEY);
        expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
        expect(timeout).toBe(1000);
    });

    it('sends a v4 Read Access Token as a Bearer header, not in the URL', async () => {
        mockConfig.TMDB_API_KEY = V4_TOKEN;
        const { getImagePath } = makeProvider();

        const path = await getImagePath('314', 'episode', 'thumb', {
            catalogId: '2a49f020-65f2-4abc-92a4-b5b68d15934a',
        });

        expect(path).toBe('/episode-still.jpg');
        const [url, init] = vi.mocked(fetchWithTimeout).mock.calls[0];
        expect(url).toBe('https://api.themoviedb.org/3/tv/314/season/1/episode/1');
        expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${V4_TOKEN}`);
    });

    it('does not treat episode poster requests as movie lookups without a direct path', async () => {
        const { provider, getImagePath } = makeProvider();
        const getTmdbPlugin = vi.fn();
        (provider as unknown as { getTmdbPlugin: typeof getTmdbPlugin }).getTmdbPlugin =
            getTmdbPlugin;

        const path = await getImagePath('314', 'episode', 'poster', {});

        expect(path).toBeNull();
        expect(getTmdbPlugin).not.toHaveBeenCalled();
    });
});

type GenerateVariants = (
    originalBuffer: Buffer,
    requestedSize: string,
    outputFormat: string,
) => Promise<{ requested: Buffer | null; variants: Array<{ sizeName: string }> }>;

describe('TmdbImageProvider variant generation', () => {
    it.each(['wide', 'hd'] as const)(
        'returns a buffer for the %s preset, which is not in the eager set',
        async (size) => {
            const { provider } = makeProvider();
            const generateVariants = (
                provider as unknown as { generateVariants: GenerateVariants }
            ).generateVariants.bind(provider);
            const original = await sharp({
                create: { width: 2400, height: 1350, channels: 3, background: '#335577' },
            })
                .jpeg()
                .toBuffer();

            const { requested } = await generateVariants(original, size, 'webp');

            expect(requested).not.toBeNull();
            const meta = await sharp(requested!).metadata();
            expect(meta.width).toBe(size === 'wide' ? 1920 : 1280);
        },
    );
});

describe('TmdbImageProvider PNG encoding', () => {
    it('serves PNG through the public provider even when the old cache contains SVG bytes', async () => {
        const { provider } = makeProvider();
        const svg = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="40" height="40" fill="red"/></svg>',
        );
        const entries = new Map<string, Buffer>([['tv-_logo_svg-logo-w500-q85.png', svg]]);
        const cache = {
            async getCachedOrFetch(key: string, fetcher: () => Promise<Buffer>) {
                const cached = entries.get(key);
                if (cached) return { buffer: cached, wasHit: true };
                const buffer = await fetcher();
                entries.set(key, buffer);
                return { buffer, wasHit: false };
            },
        };
        (provider as unknown as { cache: typeof cache }).cache = cache;
        vi.mocked(fetchWithTimeout).mockResolvedValueOnce({
            ok: true,
            arrayBuffer: async () => svg,
        } as unknown as Response);
        const request = {
            providerId: '123',
            mediaType: 'tv' as const,
            type: 'logo' as const,
            options: { path: '/logo.svg', format: 'png' as const },
        };
        const fresh = await provider.getImage(request);
        expect(fresh?.contentType).toBe('image/png');
        expect(fresh?.cacheStatus).toBe('MISS');
        expect(await sharp(fresh!.buffer).metadata()).toMatchObject({
            format: 'png',
            hasAlpha: true,
        });
        const cached = await provider.getImage(request);
        expect(cached?.cacheStatus).toBe('HIT');
        expect(cached?.buffer).toEqual(fresh?.buffer);
    });

    it.each(['logo', 'still'] as const)(
        'rasterizes SVG input for a PNG %s request and preserves transparency',
        async (type) => {
            const { provider } = makeProvider();
            const svg = Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="40" height="40" fill="red"/></svg>',
            );
            vi.mocked(fetchWithTimeout).mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => svg,
            } as unknown as Response);
            const convert = (
                provider as unknown as {
                    fetchAndConvertImage: (
                        path: string,
                        size: string,
                        type: string,
                        quality: number,
                        format: string,
                    ) => Promise<Buffer>;
                }
            ).fetchAndConvertImage.bind(provider);

            const output = await convert('/logo.svg', 'w500', type, 85, 'png');
            const metadata = await sharp(output).metadata();
            expect(metadata).toMatchObject({
                format: 'png',
                width: 80,
                height: 40,
                hasAlpha: true,
            });
            const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
            expect(data[3]).toBe(255);
            expect(data[(info.width - 1) * info.channels + 3]).toBe(0);
        },
    );
});

describe('TMDB direct path validation', () => {
    it.each([
        'https://evil.example/a.jpg',
        '//evil.example/a.jpg',
        '/../../secret.jpg',
        '/a.jpg?x=1',
        '/tmp/a.jpg',
        '/%2e%2e/a.jpg',
    ])('blocks %s before upstream or cache work', async (path) => {
        const { getImagePath } = makeProvider();
        expect(await getImagePath('603', 'movie', 'poster', { path })).toBeNull();
    });
    it('allows a canonical provider filename', async () => {
        const { getImagePath } = makeProvider();
        expect(await getImagePath('603', 'movie', 'poster', { path: '/Abc123.jpg' })).toBe(
            '/Abc123.jpg',
        );
    });
});
