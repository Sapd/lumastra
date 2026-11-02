// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import * as fileRoute from './file/[ino]/+server.js';
import * as remuxRoute from './remux/[ino]/+server.js';

const routes = [
    ['file', fileRoute],
    ['remux', remuxRoute],
] as const;

function event(method: string, path: string): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return { url, request: new Request(url, { method }), locals: {} } as unknown as RequestEvent;
}

describe.each(routes)('retired singular audiobook %s route', (_name, route) => {
    it.each(['GET', 'HEAD'] as const)(
        '%s answers 410 route_retired with a problem body and no credential',
        async (method) => {
            const response = await route[method](
                event(method, '/api/v1/audiobook/2b1f8e0e-0000-0000-0000-000000000001/file/5193'),
            );
            expect(response.status).toBe(410);
            expect(response.headers.get('content-type')).toContain('application/problem+json');
            if (method === 'HEAD') {
                expect(await response.text()).toBe('');
                return;
            }
            const body = (await response.json()) as { code: string; status: number; error: string };
            expect(body.code).toBe('route_retired');
            expect(body.status).toBe(410);
            expect(body.error).toContain('Start a new play session');
            expect(body.error).toContain('/api/v1/audiobooks/{mediaId}/files/{trackIndex}');
            expect(body.error).toContain('/api/v1/audiobooks/{mediaId}/remux/{trackIndex}');
        },
    );

    it('gives the same answer for an unknown book, so it reveals nothing', async () => {
        const response = await route.GET(
            event('GET', '/api/v1/audiobook/00000000-0000-4000-8000-000000000000/remux/1'),
        );
        expect(response.status).toBe(410);
        expect(((await response.json()) as { code: string }).code).toBe('route_retired');
    });
});
