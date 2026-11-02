// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paths', () => ({ url: (p: string) => `/sub${p}` }));

import {
    REAUTH_RELOAD_COOLDOWN_MS,
    REAUTH_RELOAD_KEY,
    buildReauthUrl,
    claimReauthReload,
    probeBrowserSession,
} from './session-reauth';

function memoryStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return {
        get length() {
            return data.size;
        },
        clear: () => data.clear(),
        getItem: (k: string) => data.get(k) ?? null,
        key: (i: number) => [...data.keys()][i] ?? null,
        removeItem: (k: string) => void data.delete(k),
        setItem: (k: string, v: string) => void data.set(k, v),
    };
}

describe('probeBrowserSession', () => {
    it('probes /api/auth/check under the base path without following redirects', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        await probeBrowserSession(fetchImpl);
        expect(fetchImpl).toHaveBeenCalledWith(
            '/sub/api/auth/check',
            expect.objectContaining({ cache: 'no-store', redirect: 'manual' }),
        );
    });

    it('is lost on 401', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
        expect(await probeBrowserSession(fetchImpl)).toBe('lost');
    });

    it('is lost when the proxy redirects the probe to its sign-in', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue({ status: 0, ok: false, type: 'opaqueredirect' } as Response);
        expect(await probeBrowserSession(fetchImpl)).toBe('lost');
    });

    it('is alive on 2xx', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        expect(await probeBrowserSession(fetchImpl)).toBe('alive');
    });

    it('is unknown for server errors and network failures', async () => {
        expect(
            await probeBrowserSession(vi.fn().mockResolvedValue(new Response('', { status: 503 }))),
        ).toBe('unknown');
        expect(await probeBrowserSession(vi.fn().mockRejectedValue(new TypeError('offline')))).toBe(
            'unknown',
        );
    });
});

describe('claimReauthReload', () => {
    it('allows the first reload and records it', () => {
        const storage = memoryStorage();
        expect(claimReauthReload(storage, 1_000_000)).toBe(true);
        expect(storage.getItem(REAUTH_RELOAD_KEY)).toBe('1000000');
    });

    it('refuses a second reload within the cooldown', () => {
        const storage = memoryStorage({ [REAUTH_RELOAD_KEY]: '1000000' });
        expect(claimReauthReload(storage, 1_000_000 + REAUTH_RELOAD_COOLDOWN_MS - 1)).toBe(false);
    });

    it('allows a reload again after the cooldown', () => {
        const storage = memoryStorage({ [REAUTH_RELOAD_KEY]: '1000000' });
        expect(claimReauthReload(storage, 1_000_000 + REAUTH_RELOAD_COOLDOWN_MS)).toBe(true);
    });

    it('treats a stored time in the future (clock changed) as expired', () => {
        const storage = memoryStorage({ [REAUTH_RELOAD_KEY]: '9000000' });
        expect(claimReauthReload(storage, 1_000_000)).toBe(true);
        expect(storage.getItem(REAUTH_RELOAD_KEY)).toBe('1000000');
    });

    it('ignores a corrupt stored value', () => {
        const storage = memoryStorage({ [REAUTH_RELOAD_KEY]: 'garbage' });
        expect(claimReauthReload(storage, 5)).toBe(true);
    });

    it('refuses without storage, since the loop guard cannot work', () => {
        expect(claimReauthReload(null, 5)).toBe(false);
        const throwing = memoryStorage();
        throwing.getItem = () => {
            throw new Error('SecurityError');
        };
        expect(claimReauthReload(throwing, 5)).toBe(false);
    });
});

describe('buildReauthUrl', () => {
    const origin = 'https://example.test';

    it('keeps the current watch page and sets t to the whole second', () => {
        expect(
            buildReauthUrl(
                `${origin}/watch/abc?fileId=f1&playlist=p`,
                '',
                'other-id-format',
                2079.78,
            ),
        ).toBe('/watch/abc?fileId=f1&playlist=p&t=2079');
    });

    it('replaces an earlier t and drops every one-shot landing param', () => {
        const current =
            `${origin}/watch/abc?t=10&resolved=series&from=x&fromPos=5&sid=s1&mk=m&fmk=f` +
            '&info=1&dev=d&seekMs=5000&slug=keep#frag';
        expect(buildReauthUrl(current, '', 'abc', 300)).toBe('/watch/abc?t=300&slug=keep');
    });

    it('drops t for unknown or sub-second positions', () => {
        expect(buildReauthUrl(`${origin}/watch/abc?t=10`, '', 'abc', null)).toBe('/watch/abc');
        expect(buildReauthUrl(`${origin}/watch/abc?t=10`, '', 'abc', 0.4)).toBe('/watch/abc');
    });

    it("goes to the item's watch page when the player runs elsewhere", () => {
        expect(buildReauthUrl(`${origin}/sub/browse?genre=x`, '/sub', 'id 1', 61)).toBe(
            '/sub/watch/id%201?t=61',
        );
    });

    it('has nothing to resume when off a watch page without an item (live)', () => {
        expect(buildReauthUrl(`${origin}/sub/livetv`, '/sub', null, null)).toBeNull();
    });

    it('never yields a protocol-relative path', () => {
        // `//evil.test/...` is a path on this origin, not a watch page: nothing to resume.
        expect(buildReauthUrl(`${origin}//evil.test/watch/abc`, '', null, 5)).toBeNull();
        // A doubled slash on a real watch page is collapsed, not passed to assign().
        expect(buildReauthUrl(`${origin}//watch/abc`, '/', 'abc', 5)).toBe('/watch/abc?t=5');
    });
});
