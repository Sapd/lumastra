// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));
const cfg = { JELLYFIN_CONTRACT_VALIDATE: 'log' as 'log' | 'off' };
vi.mock('$lib/server/config', () => ({ config: cfg }));

const { observeJellyfinResponse, resetContractLogDedupe } = await import('./runtime-hook');

function ev(path: string, method = 'POST'): Parameters<typeof observeJellyfinResponse>[0] {
    return {
        url: new URL(`http://x${path}`),
        request: new Request(`http://x${path}`, { method }),
        locals: { jfDevice: { clientName: 'Jellyfin Android TV', clientVersion: '0.19.10' } },
    } as never;
}
const badBody = {
    PlaySessionId: 'p',
    MediaSources: [{ MediaStreams: [{ Index: 0, Type: 'Subtitle' }] }],
};
const json = () =>
    new Response(JSON.stringify(badBody), { headers: { 'content-type': 'application/json' } });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    warn.mockClear();
    resetContractLogDedupe();
    cfg.JELLYFIN_CONTRACT_VALIDATE = 'log';
});
afterEach(() => vi.clearAllMocks());

describe('observeJellyfinResponse', () => {
    it('returns the original response untouched and logs each violation once per process', async () => {
        const res = json();
        observeJellyfinResponse(ev('/j/Items/a/PlaybackInfo'), res);
        expect(res.bodyUsed).toBe(false);
        await flush();
        await flush();
        const n = warn.mock.calls.length;
        expect(n).toBeGreaterThan(0);
        observeJellyfinResponse(ev('/j/Items/b/PlaybackInfo'), json());
        await flush();
        await flush();
        expect(warn.mock.calls.length).toBe(n);
    });
    it('does nothing when off and for non-JSON', async () => {
        cfg.JELLYFIN_CONTRACT_VALIDATE = 'off';
        observeJellyfinResponse(ev('/j/Items/a/PlaybackInfo'), json());
        cfg.JELLYFIN_CONTRACT_VALIDATE = 'log';
        observeJellyfinResponse(
            ev('/j/Videos/a/master.m3u8', 'GET'),
            new Response('#EXTM3U', {
                headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }),
        );
        await flush();
        await flush();
        expect(warn).not.toHaveBeenCalled();
    });
    it('does not validate a JSON body over 2 MB that has no content-length', async () => {
        const big = JSON.stringify({ PlaySessionId: 'p', pad: 'x'.repeat(2 * 1024 * 1024 + 10) });
        const res = new Response(big, { headers: { 'content-type': 'application/json' } });
        observeJellyfinResponse(ev('/j/Items/a/PlaybackInfo'), res);
        expect(res.bodyUsed).toBe(false);
        await flush();
        await flush();
        expect(warn).not.toHaveBeenCalled();
    });
    it('returns the original response when the body is already consumed', async () => {
        const res = json();
        await res.text();
        observeJellyfinResponse(ev('/j/Items/a/PlaybackInfo'), res);
        await flush();
        expect(warn).not.toHaveBeenCalled();
    });
});
