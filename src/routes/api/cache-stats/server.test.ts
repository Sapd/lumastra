// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** POST /api/cache-stats reads its JSON body through the bounded reader. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/middleware/auth', () => ({
    requireAdmin: (handler: unknown) => handler,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { POST } = await import('./+server.js');

function call(body: string): Promise<Response> {
    return (POST as (e: unknown) => Promise<Response>)({
        url: new URL('http://localhost/api/cache-stats?action=nonexistent-action'),
        locals: { user: { username: 'admin' } },
        request: new Request('http://localhost/api/cache-stats', { method: 'POST', body }),
    });
}

describe('POST /api/cache-stats body cap', () => {
    it('answers 413 for a body past the cap', async () => {
        const res = await call(JSON.stringify({ filler: 'x'.repeat(300 * 1024) }));
        expect(res.status).toBe(413);
    });

    it('does not answer 413 for a small body', async () => {
        const res = await call(JSON.stringify({ a: 1 }));
        expect(res.status).not.toBe(413);
    });
});
