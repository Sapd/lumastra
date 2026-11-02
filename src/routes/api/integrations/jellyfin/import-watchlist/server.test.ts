// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn() }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi
        .fn()
        .mockResolvedValue({ allowed: true, resetAt: 0, remaining: 3, total: 3 }),
}));
vi.mock('$lib/server/services/jellyfin-watchlist-import.service.js', () => ({
    importJellyfinFavoritesToWatchlist: vi.fn(),
}));

import { getDb } from '$lib/server/database/connection.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { importJellyfinFavoritesToWatchlist } from '$lib/server/services/jellyfin-watchlist-import.service.js';
import { jellyfinImportWatchlistDef } from '$lib/server/api/defs/integrations/jellyfin/import-watchlist.js';

const TEST_USER = {
    userId: toUserId('00000000-0000-0000-0000-000000000001'),
    username: 'basti',
};

function makeEvent(user: typeof TEST_USER | null) {
    return { locals: { user } } as never;
}

describe('POST /api/integrations/jellyfin/import-watchlist', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getDb).mockReturnValue({} as never);
        vi.mocked(checkRateLimit).mockResolvedValue({
            allowed: true,
            resetAt: 0,
            remaining: 3,
            total: 3,
        });
    });

    it('returns 401 when unauthenticated', async () => {
        const response = await jellyfinImportWatchlistDef.handlers.POST!(
            makeEvent(null),
            {} as never,
        );
        expect(response.status).toBe(401);
    });

    it('returns 429 when rate limited', async () => {
        vi.mocked(checkRateLimit).mockResolvedValue({
            allowed: false,
            resetAt: Date.now() + 1000,
            remaining: 0,
            total: 3,
        });

        const response = await jellyfinImportWatchlistDef.handlers.POST!(
            makeEvent(TEST_USER),
            {} as never,
        );

        expect(response.status).toBe(429);
    });

    it('returns 503 when the import service reports unavailable', async () => {
        vi.mocked(importJellyfinFavoritesToWatchlist).mockResolvedValue({
            ok: false,
            reason: 'unavailable',
        });

        const response = await jellyfinImportWatchlistDef.handlers.POST!(
            makeEvent(TEST_USER),
            {} as never,
        );

        expect(response.status).toBe(503);
    });

    it('returns 200 with counts on success', async () => {
        vi.mocked(importJellyfinFavoritesToWatchlist).mockResolvedValue({
            ok: true,
            imported: 42,
            skipped: 3,
            total: 45,
        });

        const response = await jellyfinImportWatchlistDef.handlers.POST!(
            makeEvent(TEST_USER),
            {} as never,
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ imported: 42, skipped: 3, total: 45 });
    });
});
