// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin status payload's service-version probe calls Jellyfin's
 * `/System/Info` only when the optional Jellyfin sync may call out
 * (`canCallJellyfin()`); a configured URL + key alone is not enough.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    canCallJellyfin: vi.fn(() => false),
    fetch: vi.fn(),
}));

vi.mock('$lib/server/jellyfin/runtime-gate.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/jellyfin/runtime-gate.js')>()),
    canCallJellyfin: () => h.canCallJellyfin(),
}));

vi.mock('$lib/server/utils/fetch-utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>()),
    fetchWithTimeout: (...args: unknown[]) => h.fetch(...args),
}));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    const cfg = new Proxy(actual.config, {
        get(target, key, receiver) {
            if (key === 'JELLYFINURL') return 'http://jellyfin:8096/jellyfin/';
            if (key === 'AUDIOURL') return 'http://abs:80/audiobookshelf/';
            if (key === 'AUDIOAPIKEY') return 'abs-key';
            if (key === 'JELLYFINAPIKEY') return 'jf-key';
            if (
                typeof key === 'string' &&
                /^(SEERR|SONARR|RADARR|AUDIO|KAVITA)(URL|APIKEY)$/.test(key)
            ) {
                return '';
            }
            return Reflect.get(target, key, receiver);
        },
    });
    return { ...actual, config: cfg };
});

const { fetchServiceVersions } = await import('./admin-status-payload.service.js');

function jellyfinCalls(): unknown[][] {
    return h.fetch.mock.calls.filter((c) => String(c[0]).includes('/System/Info'));
}

describe('fetchServiceVersions — Jellyfin', () => {
    beforeEach(() => {
        h.fetch.mockReset();
        h.fetch.mockResolvedValue(
            new Response(JSON.stringify({ Version: '10.10.0', serverVersion: '2.36.0' }), {
                status: 200,
            }),
        );
    });

    it('reads the ABS version from its public status endpoint under the base path', async () => {
        const versions = await fetchServiceVersions();
        expect(h.fetch.mock.calls.map(([url]) => url)).toContain(
            'http://abs/audiobookshelf/status',
        );
        expect(versions.audiobookshelf).toBe('2.36.0');
    });

    it('does not call Jellyfin when sync is off / unreachable, despite URL + key', async () => {
        h.canCallJellyfin.mockReturnValue(false);

        const versions = await fetchServiceVersions();

        expect(jellyfinCalls()).toHaveLength(0);
        expect(versions.jellyfin).toBeUndefined();
    });

    it('asks Jellyfin for its version when the runtime gate allows it', async () => {
        h.canCallJellyfin.mockReturnValue(true);

        const versions = await fetchServiceVersions();

        expect(jellyfinCalls()).toHaveLength(1);
        expect(jellyfinCalls()[0][0]).toBe('http://jellyfin:8096/jellyfin/System/Info');
        expect(versions.jellyfin).toBe('10.10.0');
        expect(jellyfinCalls()[0][1]).toMatchObject({
            headers: {
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="jf-key"$/,
                ),
            },
        });
    });
});
