// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F33 — throw err escapes inside handler bodies.
 *
 * Finding: Two versioned API routes re-throw non-specific exceptions inside
 * catch blocks. One Jellyfin route uses throw error(404, 'Not Found'),
 * leaking SvelteKit framework details.
 *
 * Citations: src/routes/api/v1/runs/stream/+server.ts:60,
 *            src/routes/api/v1/webhooks/[id]/test/+server.ts:60,
 *            src/routes/j/web/[...path]/+server.ts:66
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const mockGetClient = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/cache/valkey.js', () => ({
    getClient: mockGetClient,
    getValkeyClient: vi.fn(() => null),
    getCoordinationClient: vi.fn(() => null),
    subscribeToChannel: vi.fn(async () => null),
    publishMessage: vi.fn(async () => true),
}));

describe('F33 — Re-thrown exceptions leak framework details in API handlers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('v1 runs/stream handler should catch Valkey errors and return a safe response', async () => {
        // `readReplaySince` is an internal helper that may or may not be
        // exported; access it via the module namespace so the import type-checks
        // regardless, and the runtime guard below picks the right code path.
        const serverModule: Record<string, unknown> = await import('./+server.js');
        const readReplaySince = serverModule.readReplaySince as
            ((sinceId?: number) => Promise<unknown>) | undefined;

        // CORRECT behavior: When Valkey throws, the handler should catch the
        // error and return a safe, non-leaking response (e.g., empty array
        // or a 500 with generic message) — NOT re-throw the raw exception.
        mockGetClient.mockImplementation(() => {
            throw new Error('Connection refused');
        });

        // If readReplaySince is exported, we test it directly.
        if (typeof readReplaySince === 'function') {
            // The function should NOT throw — it should handle errors gracefully.
            await expect(readReplaySince()).resolves.not.toThrow();
        } else {
            // If not exported, test via the module source pattern.
            // We verify the handler doesn't throw by importing GET.
            const { GET } = (await import('./+server.js'))!;
            const event = {
                url: new URL('http://localhost/api/v1/runs/stream?sinceId=0'),
                request: { method: 'GET' },
                locals: { user: { ownerIsAdmin: true } },
                params: {},
                route: { id: null },
                cookies: {} as never,
                fetch,
                getClientAddress: () => '127.0.0.1',
                platform: undefined,
                isDataRequest: false,
                isSubRequest: false,
                setHeaders: () => undefined,
                depends: () => undefined,
                untrack: <T>(fn: () => T) => fn(),
            } as unknown as import('@sveltejs/kit').RequestEvent;

            // CORRECT behavior: should NOT throw even on Valkey failure.
            await expect(GET!(event)).resolves.not.toThrow();
        }
    });
});
