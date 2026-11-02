// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
    deriveLiveTvViewerKey,
    liveTvCredentialFingerprint,
    peekLiveTvViewerKey, isLiveTvPreviewRequest, liveTvJoinPriority } from './livetv-viewer-key.js';

function input(overrides: Partial<App.Locals> = {}) {
    const values = new Map<string, string>();
    const cookies = {
        get: vi.fn((name: string) => values.get(name)),
        set: vi.fn((name: string, value: string) => values.set(name, value)),
    };
    return {
        value: {
            locals: {
                user: { username: 'alice' },
                ...overrides,
            } as App.Locals,
            cookies,
        },
        cookies,
    };
}

describe('deriveLiveTvViewerKey', () => {
    it('uses the authenticated credential discriminator identically across requests', () => {
        const first = input({ liveTvCredentialId: 'session:s1' });
        const second = input({ liveTvCredentialId: 'session:s1' });
        expect(deriveLiveTvViewerKey(first.value)).toBe('alice:session:s1');
        expect(deriveLiveTvViewerKey(second.value)).toBe('alice:session:s1');
        expect(first.cookies.set).not.toHaveBeenCalled();
    });

    it('keeps two devices on one account distinct', () => {
        expect(deriveLiveTvViewerKey(input({ liveTvCredentialId: 'device:a' }).value)).not.toBe(
            deriveLiveTvViewerKey(input({ liveTvCredentialId: 'device:b' }).value),
        );
    });

    it('persists a private browser discriminator when forward auth has no id', () => {
        const browser = input();
        const first = deriveLiveTvViewerKey(browser.value);
        const second = deriveLiveTvViewerKey(browser.value);
        expect(second).toBe(first);
        expect(browser.cookies.set).toHaveBeenCalledOnce();
    });

    it('fingerprints replayable credentials without exposing them', () => {
        const result = liveTvCredentialFingerprint('jf-play', 'secret-token');
        expect(result).toMatch(/^jf-play:[a-f0-9]{64}$/);
        expect(result).not.toContain('secret-token');
    });
});

describe('peekLiveTvViewerKey', () => {
    it.each([
        ['a credential id', { liveTvCredentialId: 'stream:t1' }],
        ['a Jellyfin device', { jfDevice: { deviceId: 'living-room' } } as Partial<App.Locals>],
        ['a device session', { deviceSessionId: 'ds-9' }],
    ])('returns the key derive gives for %s', (_label, locals) => {
        const peeked = input(locals as Partial<App.Locals>);
        const derived = input(locals as Partial<App.Locals>);
        expect(peekLiveTvViewerKey(peeked.value)).toBe(deriveLiveTvViewerKey(derived.value));
        expect(peeked.cookies.set).not.toHaveBeenCalled();
    });

    it('returns the browser key once the cookie exists, and never mints one', () => {
        const browser = input();
        expect(peekLiveTvViewerKey(browser.value)).toBeNull();
        expect(browser.cookies.set).not.toHaveBeenCalled();
        const derived = deriveLiveTvViewerKey(browser.value);
        expect(peekLiveTvViewerKey(browser.value)).toBe(derived);
    });
});

describe('hover-preview viewer isolation', () => {
    it('gives a preview its own viewer key, from the option or the preview=1 marker', () => {
        const real = deriveLiveTvViewerKey(input({ liveTvCredentialId: 'stream:t1' }).value);
        const viaOption = deriveLiveTvViewerKey(input({ liveTvCredentialId: 'stream:t1' }).value, {
            preview: true,
        });
        const viaUrl = deriveLiveTvViewerKey({
            ...input({ liveTvCredentialId: 'stream:t1' }).value,
            url: new URL('http://localhost/x/master.m3u8?preview=1'),
        });
        expect(viaOption).toBe(`${real}:preview`);
        expect(viaUrl).toBe(viaOption);
        expect(real.endsWith(':preview')).toBe(false);
    });

    it('a preview never outranks real playback', () => {
        expect(liveTvJoinPriority('high', true)).toBe('low');
        expect(liveTvJoinPriority('high', false)).toBe('high');
        expect(isLiveTvPreviewRequest(new URL('http://localhost/a?preview=1'))).toBe(true);
        expect(isLiveTvPreviewRequest(new URL('http://localhost/a'))).toBe(false);
    });
});
