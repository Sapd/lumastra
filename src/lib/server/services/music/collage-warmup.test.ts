// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { musicCollageImages } from './collage-images.js';
import { musicImagesFixture } from './__tests__/image-fixtures.js';

const { render, resolve, debug } = vi.hoisted(() => ({
    render: vi.fn(),
    resolve: vi.fn(),
    debug: vi.fn(),
}));
vi.mock('./cover-collage.service.js', () => ({ getCoverCollage: render }));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({ resolveImageSets: resolve }));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => ({ debug }) } }));

import { warmCollageUrls, warmMusicCollages } from './collage-warmup.js';

beforeEach(() => {
    vi.clearAllMocks();
    render.mockResolvedValue(null);
});

describe('collage warm-up', () => {
    it('warms every published preset with exactly its ids and artwork revision', async () => {
        const members = new Map([['album', musicImagesFixture('album', 'v1')]]);
        resolve.mockResolvedValue(members);
        const published = musicCollageImages(['album', 'album'], 'v1', members).primary!;
        expect(warmMusicCollages({} as Sql, [['album', 'album']])).toBeUndefined();
        await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3));
        for (const href of Object.values(published.variants!)) {
            const url = new URL(href, 'http://localhost');
            expect(render).toHaveBeenCalledWith(
                url.searchParams.get('ids')!.split(','),
                url.searchParams.get('size'),
                url.searchParams.get('v'),
            );
        }
    });

    it('swallows render errors, logs only at debug and continues warming', async () => {
        render.mockRejectedValueOnce(new Error('render failed'));
        await expect(
            warmCollageUrls([
                '/api/music/images/collage?ids=a&size=card&v=r',
                '/api/v1/music/images/collage?ids=b&size=thumb&v=s',
            ]),
        ).resolves.toBeUndefined();
        expect(render).toHaveBeenCalledTimes(2);
        expect(debug).toHaveBeenCalledWith('Collage warm-up failed', {
            error: 'Error: render failed',
        });
    });

    it('does not block the producer when preparation fails', async () => {
        expect(
            warmMusicCollages({} as Sql, async () => {
                throw new Error('lookup failed');
            }),
        ).toBeUndefined();
        await vi.waitFor(() =>
            expect(debug).toHaveBeenCalledWith('Collage warm-up preparation failed', {
                error: 'Error: lookup failed',
            }),
        );
        expect(render).not.toHaveBeenCalled();
    });

    it('bounds rendering to two globally and deduplicates overlapping surfaces', async () => {
        const releases: Array<() => void> = [];
        let active = 0;
        let peak = 0;
        render.mockImplementation(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise<void>((done) => releases.push(done));
            active--;
        });
        const urls = ['a', 'b', 'c'].map(
            (id) => `/api/music/images/collage?ids=${id}&size=card&v=r`,
        );
        const first = warmCollageUrls(urls);
        const second = warmCollageUrls([urls[0].replace('/api/', '/api/v1/')]);
        await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
        releases.shift()!();
        await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3));
        releases.splice(0).forEach((done) => done());
        await Promise.all([first, second]);
        expect(peak).toBe(2);
        expect(render).toHaveBeenCalledTimes(3);
    });
});
