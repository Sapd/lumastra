// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device ids are opaque client strings. Interpolated raw, an id with `/`,
 * `?`, `#` or `%` hit the wrong route or lost its tail.
 */

import { describe, it, expect, vi } from 'vitest';

const apiGet = vi.hoisted(() =>
    vi.fn(async (..._args: unknown[]) => ({ data: null, error: null })),
);
vi.mock('./client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./client.js')>();
    return { ...actual, apiGet };
});

import { getDevicePlaybackQuality, getUserPlaybackQuality } from './admin.js';

describe('playback-quality drill-down URLs', () => {
    it('encodes a device id with path and query characters', async () => {
        await getDevicePlaybackQuality('tv/1?x#y%', 7);
        expect(apiGet.mock.lastCall?.[0]).toBe(
            '/api/admin/playback-quality/device/tv%2F1%3Fx%23y%25',
        );
    });

    it('encodes the user id', async () => {
        await getUserPlaybackQuality('a/b', 7);
        expect(apiGet.mock.lastCall?.[0]).toBe('/api/admin/playback-quality/user/a%2Fb');
    });
});
