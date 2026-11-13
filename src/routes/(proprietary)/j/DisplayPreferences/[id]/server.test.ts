// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C6: request-budget tests for POST /j/DisplayPreferences/{id} — the three
 * findings from the 2026-09-13 fix plan (oversized body, unbounded id/client
 * length, unbounded per-user row growth). Mocks the DB query module (per the
 * task brief: "route test on a real PG (or mocked sql)") rather than a real
 * Postgres, so this runs without integration infrastructure.
 *
 * Bypasses withJellyfinAuth via vi.mock, mirroring the existing
 * server.integration.test.ts in this directory.
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

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const mockGetDisplayPreferences = vi.fn();
const mockUpsertDisplayPreferences = vi.fn();
const mockDisplayPreferencesRowExists = vi.fn();
const mockCountDisplayPreferencesRowsForUser = vi.fn();

vi.mock('$lib/server/database/queries/jellyfin-display-preferences.queries', () => ({
    getDisplayPreferences: (...args: unknown[]) => mockGetDisplayPreferences(...args),
    upsertDisplayPreferences: (...args: unknown[]) => mockUpsertDisplayPreferences(...args),
    displayPreferencesRowExists: (...args: unknown[]) => mockDisplayPreferencesRowExists(...args),
    countDisplayPreferencesRowsForUser: (...args: unknown[]) =>
        mockCountDisplayPreferencesRowsForUser(...args),
}));

// A truthy stand-in for `sql` — the route only checks `if (!sql)`.
const fakeSql = {} as never;
vi.mock('$lib/server/database', () => ({
    getDb: () => fakeSql,
}));

const USER_ID = toUserId('11111111-1111-4111-a111-111111111111');

function buildEvent(
    id: string,
    method: string,
    opts: { query?: string; body?: unknown; contentLength?: string } = {},
): RequestEvent {
    const url = `http://localhost/j/DisplayPreferences/${id}${opts.query ?? ''}`;
    const init: RequestInit = { method };
    if (opts.body !== undefined) {
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        const headers = new Headers({ 'content-type': 'application/json' });
        if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength);
        init.headers = headers;
    }
    return {
        url: new URL(url),
        request: new Request(url, init),
        locals: {
            user: { userId: USER_ID, username: 'alice' },
        },
        params: { id },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing row (new pair), plenty of room under the cap.
    mockDisplayPreferencesRowExists.mockResolvedValue(false);
    mockCountDisplayPreferencesRowsForUser.mockResolvedValue(0);
    mockUpsertDisplayPreferences.mockResolvedValue(undefined);
});

describe('POST /j/DisplayPreferences/{id} — request budgets (C6)', () => {
    it('rejects a >64KB body with 413 BEFORE any DB write call', async () => {
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const bigBody = { CustomPrefs: { blob: 'x'.repeat(100_000) } };

        const res = await POST!(buildEvent('customview-abc', 'POST', { body: bigBody }));

        expect(res.status).toBe(413);
        expect(mockUpsertDisplayPreferences).not.toHaveBeenCalled();
    });

    it('rejects a declared Content-Length over 64KB before reading further', async () => {
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST!(
            buildEvent('customview-abc', 'POST', {
                body: { small: true },
                contentLength: '100000',
            }),
        );

        expect(res.status).toBe(413);
        expect(mockUpsertDisplayPreferences).not.toHaveBeenCalled();
    });

    it('refuses the 201st distinct (id, client) pair for a user with 409, not touching upsert', async () => {
        mockDisplayPreferencesRowExists.mockResolvedValue(false); // genuinely new pair
        mockCountDisplayPreferencesRowsForUser.mockResolvedValue(200); // already at the cap

        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST!(
            buildEvent('brand-new-view', 'POST', { body: { SortBy: 'DateCreated' } }),
        );

        expect(res.status).toBe(409);
        expect(mockUpsertDisplayPreferences).not.toHaveBeenCalled();
    });

    it('an UPDATE to an existing (id, client) pair is never capped, even at 200 rows', async () => {
        mockDisplayPreferencesRowExists.mockResolvedValue(true); // existing pair — an update
        mockCountDisplayPreferencesRowsForUser.mockResolvedValue(200);

        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST!(
            buildEvent('existing-view', 'POST', { body: { SortBy: 'DateCreated' } }),
        );

        expect(res.status).toBe(204);
        expect(mockUpsertDisplayPreferences).toHaveBeenCalledOnce();
    });

    it('rejects an id over 128 characters with 422/400, before touching the DB', async () => {
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const longId = 'a'.repeat(129);
        const res = await POST!(buildEvent(longId, 'POST', { body: { SortBy: 'SortName' } }));

        expect([400, 422]).toContain(res.status);
        expect(mockUpsertDisplayPreferences).not.toHaveBeenCalled();
        expect(mockCountDisplayPreferencesRowsForUser).not.toHaveBeenCalled();
    });

    it('rejects a ?client= over 128 characters', async () => {
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const longClient = '?client=' + 'c'.repeat(129);
        const res = await POST!(
            buildEvent('customview-abc', 'POST', {
                body: { SortBy: 'SortName' },
                query: longClient,
            }),
        );

        expect([400, 422]).toContain(res.status);
        expect(mockUpsertDisplayPreferences).not.toHaveBeenCalled();
    });

    it('a normal-sized, within-cap POST still succeeds (no regression)', async () => {
        const { POST } = (await import('./+server')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST!(
            buildEvent('customview-abc', 'POST', { body: { SortBy: 'DateCreated' } }),
        );

        expect(res.status).toBe(204);
        expect(mockUpsertDisplayPreferences).toHaveBeenCalledOnce();
    });
});
