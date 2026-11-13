// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: vi.fn(), del: vi.fn(), ready: false }));
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: vi.fn(async () => null as string | null),
    cacheSet: vi.fn(),
    cacheDel: h.del,
    hGetAll: async () => ({}),
    hGet: vi.fn(),
    hSetWithMaxTtl: vi.fn(),
    expire: vi.fn(),
    isValkeyReadyFor: () => h.ready,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ debug: vi.fn(), warn: vi.fn(), error: h.error }) },
}));
import { cacheGet, expire } from '$lib/server/cache/valkey';
import { renewPlayTokenBySession, revokePlayTokenBySession } from './play-token';

beforeEach(() => {
    vi.clearAllMocks();
    h.ready = false;
});

it('logs loudly when cache unavailability prevents revocation', async () => {
    await revokePlayTokenBySession('kicked-session');
    expect(h.error).toHaveBeenCalledWith(
        expect.stringMatching(/revok.*unavailable|unavailable.*revok/i),
        expect.objectContaining({ playSessionId: 'kicked-session' }),
    );
});

it('does not renew another session using an unrelated presented token', async () => {
    vi.mocked(cacheGet).mockResolvedValue('victim-token');
    await renewPlayTokenBySession('victim-session', { token: 'attacker-token' });
    expect(expire).not.toHaveBeenCalled();
});
it('renews a bound root token and refuses progress from a foreign user', async () => {
    vi.mocked(cacheGet).mockImplementation(async (key) =>
        key.startsWith('directplay:session:')
            ? 'root'
            : JSON.stringify({ userId: 'alice', itemId: 'movie' }),
    );
    await renewPlayTokenBySession('session', { token: 'root' });
    expect(expire).toHaveBeenCalled();
    vi.mocked(expire).mockClear();
    await renewPlayTokenBySession('session', { userId: 'bob', itemId: 'movie' });
    expect(expire).not.toHaveBeenCalled();
});

it('allows own progress and rejects a different item', async () => {
    vi.mocked(cacheGet).mockImplementation(async (key) =>
        key.startsWith('directplay:session:')
            ? 'root'
            : JSON.stringify({ userId: 'alice', itemId: 'movie' }),
    );
    await renewPlayTokenBySession('session', { userId: 'alice', itemId: 'other' });
    expect(expire).not.toHaveBeenCalled();
    await renewPlayTokenBySession('session', { userId: 'alice', itemId: 'movie' });
    expect(expire).toHaveBeenCalled();
});

it.each([
    ['abcdefab-1234-4567-89ab-abcdefabcdef', 'ABCDEFAB1234456789ABABCDEFABCDEF'],
    ['ABCDEFAB1234456789ABABCDEFABCDEF', 'abcdefab-1234-4567-89ab-abcdefabcdef'],
])('renews progress across UUID spellings %s / %s', async (stored, reported) => {
    vi.mocked(cacheGet).mockImplementation(async (key) =>
        key.startsWith('directplay:session:')
            ? 'root'
            : JSON.stringify({ userId: 'alice', itemId: stored }),
    );
    await renewPlayTokenBySession('session', { userId: 'alice', itemId: reported });
    expect(expire).toHaveBeenCalled();
});
