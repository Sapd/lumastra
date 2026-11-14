// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

const record = vi.fn();
vi.mock('$lib/server/jellyfin-compat/unknown-route-log.js', () => ({
    recordUnknownRoute: (...a: unknown[]) => record(...a),
}));

import { fallback } from './+server.js';

describe('/j catch-all', () => {
    const call = () =>
        fallback({
            request: new Request('http://x/j/Nope', { method: 'GET' }),
            url: new URL('http://x/j/Nope'),
        } as never) as Response;

    it('returns the identical Jellyfin 404 envelope', async () => {
        const res = call();
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(await res.text()).toBe('{"Status":"NotFound"}');
        expect(record).toHaveBeenCalledWith(expect.any(Request), '/j/Nope');
    });

    it('still 404s when the recorder throws', async () => {
        record.mockImplementationOnce(() => {
            throw new Error('x');
        });
        expect(call().status).toBe(404);
    });
});
