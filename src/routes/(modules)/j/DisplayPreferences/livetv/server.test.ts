// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C6 smoke test for POST /j/DisplayPreferences/livetv — see the sibling
 * usersettings/server.test.ts docstring; this confirms THIS route wires the
 * same shared guards in, using its fixed `livetv` display-prefs id.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';

// The real message barrel costs ~35 s to load cold and blew the 30 s timeout —
// see the stub's header.
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const mockUpsertDisplayPreferences = vi.fn();
const mockDisplayPreferencesRowExists = vi.fn();
const mockCountDisplayPreferencesRowsForUser = vi.fn();

vi.mock('$lib/server/database/queries/jellyfin-display-preferences.queries', () => ({
    getDisplayPreferences: vi.fn(),
    upsertDisplayPreferences: (...args: unknown[]) => mockUpsertDisplayPreferences(...args),
    displayPreferencesRowExists: (...args: unknown[]) => mockDisplayPreferencesRowExists(...args),
    countDisplayPreferencesRowsForUser: (...args: unknown[]) =>
        mockCountDisplayPreferencesRowsForUser(...args),
}));

vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));

const USER_ID = toUserId('33333333-3333-4333-a333-333333333333');

function buildEvent(body: unknown): RequestEvent {
    const url = 'http://localhost/j/DisplayPreferences/livetv';
    return {
        url: new URL(url),
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        locals: { user: { userId: USER_ID, username: 'carol' } },
        params: {},
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockDisplayPreferencesRowExists.mockResolvedValue(false);
    mockCountDisplayPreferencesRowsForUser.mockResolvedValue(0);
    mockUpsertDisplayPreferences.mockResolvedValue(undefined);
});

describe('POST /j/DisplayPreferences/livetv — request budgets (C6)', () => {
    it('rejects a >64KB body with 413', async () => {
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST!(buildEvent({ CustomPrefs: { blob: 'x'.repeat(100_000) } }));
        expect(res.status).toBe(413);
        expect(mockUpsertDisplayPreferences).not.toHaveBeenCalled();
    });

    it('refuses at the 200-row cap for a genuinely new (id, client) pair', async () => {
        mockCountDisplayPreferencesRowsForUser.mockResolvedValue(200);
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST!(buildEvent({ SortBy: 'DateCreated' }));
        expect(res.status).toBe(409);
        expect(mockUpsertDisplayPreferences).not.toHaveBeenCalled();
    });

    it('a normal POST succeeds (no regression)', async () => {
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST!(buildEvent({ SortBy: 'DateCreated' }));
        expect(res.status).toBe(204);
        expect(mockUpsertDisplayPreferences).toHaveBeenCalledOnce();
    });
});
