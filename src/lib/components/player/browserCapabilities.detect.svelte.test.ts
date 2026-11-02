// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

async function detect(options: {
    fileMain10: boolean;
    mseMain10: boolean;
    mseMain?: boolean;
    mediaCapabilities?: boolean;
    throwMse?: boolean;
    mcSupported?: boolean;
}) {
    vi.resetModules();
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((mime) => {
        if (mime.includes('hvc1.2.')) return options.fileMain10 ? 'probably' : '';
        if (mime.includes('hvc1.1.')) return 'probably';
        // Native HLS may accept its container MIME even with an unknown codec.
        if (mime.includes('mpegurl')) return 'maybe';
        return mime.includes('avc1') || mime.includes('mp4a') || mime === 'video/mp4'
            ? 'probably'
            : '';
    });
    vi.stubGlobal('MediaSource', {
        isTypeSupported: vi.fn((mime: string) => {
            if (options.throwMse) throw new Error('unsupported');
            if (mime.includes('hvc1.2.')) return options.mseMain10;
            if (mime.includes('hvc1.1.')) return options.mseMain ?? true;
            return mime.includes('avc1') || mime.includes('mp4a');
        }),
    });
    vi.stubGlobal('navigator', {
        userAgent: 'Firefox/144.0',
        platform: 'Linux',
        maxTouchPoints: 0,
        ...(options.mediaCapabilities === false
            ? {}
            : {
                  mediaCapabilities: {
                      decodingInfo: vi.fn().mockResolvedValue({
                          supported: options.mcSupported ?? true,
                          smooth: true,
                          powerEfficient: true,
                      }),
                  },
              }),
    });
    const capabilities = await import('./browserCapabilities.svelte');
    await capabilities.ensurePathScopedCapabilities();
    return {
        ...capabilities.getCapabilities(),
        ...(await capabilities.ensurePathScopedCapabilities()),
    };
}
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('HEVC capability detection', () => {
    it('honors a MediaCapabilities denial despite canPlayType HEVC confirmation', async () => {
        const caps = await detect({ fileMain10: true, mseMain10: true, mcSupported: false });
        expect(caps.h265.supported).toBe(false);
    });
    it('does not claim 10-bit HEVC from 8-bit support or optimistic MediaCapabilities', async () => {
        const caps = await detect({ fileMain10: false, mseMain10: false });
        expect(caps?.directFile!.videoCodecs).not.toContain('hevc');
        expect(caps?.nativeHls!.videoCodecs).not.toContain('hevc');
        expect(caps?.mseHls!.videoCodecs).not.toContain('hevc');
    });
    it('claims HEVC only on paths that confirm Main and Main 10', async () => {
        const caps = await detect({ fileMain10: true, mseMain10: true });
        expect(caps?.directFile!.videoCodecs).toContain('hevc');
        expect(caps?.nativeHls!.videoCodecs).toContain('hevc');
        expect(caps?.mseHls!.videoCodecs).toContain('hevc');
    });
    it('does not let native file support leak into MSE', async () => {
        const caps = await detect({ fileMain10: true, mseMain10: false });
        expect(caps?.nativeHls!.videoCodecs).toContain('hevc');
        expect(caps?.mseHls!.videoCodecs).not.toContain('hevc');
    });
    it('accepts MSE confirmation without claiming native support', async () => {
        const caps = await detect({ fileMain10: false, mseMain10: true });
        expect(caps?.directFile!.videoCodecs).not.toContain('hevc');
        expect(caps?.mseHls!.videoCodecs).toContain('hevc');
    });
    it('requires both profiles in the MSE fallback without MediaCapabilities', async () => {
        const caps = await detect({
            fileMain10: true,
            mseMain10: true,
            mseMain: false,
            mediaCapabilities: false,
        });
        expect(caps?.mseHls!.videoCodecs).not.toContain('hevc');
    });
    it('handles throwing MSE probes conservatively', async () => {
        const caps = await detect({ fileMain10: true, mseMain10: true, throwMse: true });
        expect(caps?.mseHls!.videoCodecs).not.toContain('hevc');
    });
});
