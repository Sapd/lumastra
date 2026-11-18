// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$lib/server/utils/client-ip', () => ({ isForwardAuthPeerTrusted: () => true }));

const { GET } = await import('./+server');

function call(path: string | undefined) {
    const event = { params: { path }, getClientAddress: () => '10.0.0.1' };
    return (GET as unknown as (e: typeof event) => Response)(event);
}

describe('/j/web/*', () => {
    // The LG webOS Jellyfin app JSON-parses /web/manifest.json; HTML made it
    // report "did not return valid JSON". A JSON 404 is a clear "not Jellyfin".
    it.each(['manifest.json', 'MANIFEST.JSON'])('answers %s with a JSON 404', async (path) => {
        const res = call(path);
        expect(res.status).toBe(404);
        expect(res.headers.get('Content-Type')).toBe('application/json');
        expect(await res.json()).toEqual({ Status: 'NotFound' });
    });

    it.each(['index.html', undefined])(
        'still serves the deep-link redirect HTML for %s',
        async (path) => {
            const res = call(path);
            expect(res.status).toBe(200);
            expect(res.headers.get('Content-Type')).toContain('text/html');
            expect(await res.text()).toContain('location.replace');
        },
    );
});
