// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import type { ImageCandidate } from '$lib/schemas/image-candidates.js';
import { ImageProxyService } from './service.js';

const candidate: ImageCandidate = {
    id: '11111111-1111-4111-8111-111111111111',
    media_item_id: '22222222-2222-4222-8222-222222222222',
    artwork_type: 'poster',
    provider: 'jellyfin',
    provider_ref: 'http://jellyfin.local/Items/upstream/Images/Primary',
    remote_url: 'http://jellyfin.local/Items/upstream/Images/Primary',
    file_path: null,
    language: '',
    width: null,
    height: null,
    chosen_by: 'admin',
    fetched_at: '2026-10-24',
    locked: true,
    selected: true,
    sort_order: 0,
};

describe('selected integration artwork', () => {
    it('uses authenticated Jellyfin handling for configured private server URLs', async () => {
        const service = new ImageProxyService({} as never);
        const fetchCustomUrl = vi.fn();
        const getJellyfinImage = vi.fn().mockResolvedValue(null);
        Object.assign(service, {
            fetchCustomUrl,
            getJellyfinImage,
            cachedGetImageMetadata: vi
                .fn()
                .mockResolvedValue({ jellyfin_id: 'abcdef0123456789abcdef0123456789' }),
        });
        await service.serveImageCandidate(candidate, 'poster');
        expect(getJellyfinImage).toHaveBeenCalledWith(
            'abcdef0123456789abcdef0123456789',
            'poster',
            {},
        );
        expect(fetchCustomUrl).not.toHaveBeenCalled();
    });
    it('does not silently fetch a replacement after a locked selected provider misses', async () => {
        const service = new ImageProxyService({} as never);
        const fetchCustomUrl = vi.fn().mockResolvedValue(null);
        const getTmdbImage = vi.fn();
        Object.assign(service, { fetchCustomUrl, getTmdbImage });
        await expect(
            service.serveImageCandidate(
                {
                    ...candidate,
                    provider: 'discogs',
                    provider_ref: 'https://i.discogs.com/missing.jpg',
                    remote_url: 'https://i.discogs.com/missing.jpg',
                },
                'poster',
            ),
        ).resolves.toBeNull();
        expect(fetchCustomUrl).toHaveBeenCalledOnce();
        expect(getTmdbImage).not.toHaveBeenCalled();
    });
});
